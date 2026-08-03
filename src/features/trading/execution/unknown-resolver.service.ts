import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/trading/risk';
import {
  EXCHANGE_PORT,
  AdapterError,
  type ExchangePort,
  type ExchangeOrderState,
  type AlgoOrderState,
  type VenueFill,
} from '../../../ports/venue/exchange';
import { EXECUTION_STORE, type ExecutionStorePort } from '../../../ports/trading/execution';
import {
  reduce,
  TERMINAL_ORDER_STATES,
  type OrderEvent,
  type OrderRecord,
} from '../../../domain/trading/oms/reducer';
import { isAlgoRailIntent } from '../../../domain/trading/oms/reconcile';
import { mulberry32 } from '../../../domain/common/rng/prng';
import {
  queryBackoffMs,
  MAX_QUERY_ATTEMPTS,
  UNKNOWN_KILL_AFTER_MS,
} from '../../../domain/trading/oms/query-backoff';
import { price, qty, feeAmount } from '../../../domain/common/types/money';
import type { ClientOrderId, SymbolId, EpochMs } from '../../../domain/common/types/ids';
import type { FillRecord } from '../../../domain/trading/types/exec-report';
import type { OrderIntent } from '../../../domain/trading/types/order-intent';
import { OrderBookService } from './order-book.service';
import { PortfolioStateService } from './portfolio-state.service';
import { FillIngestorService } from './fill-ingestor.service';

const TERMINAL = TERMINAL_ORDER_STATES;
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(['OrderNotFound', 'ORDER_NOT_FOUND']);
const MAX_CANCEL_REISSUES = 3; // §6.1: >3 cancel reissues while still open ⇒ RECONCILE_REQUIRED
const JITTER_SEED = 0x5165_5279; // fixed ⇒ the ±20% backoff jitter replays deterministically

// 2026-07-27 defect fix: RECONCILE_REQUIRED was a permanent trap — no mechanism ever re-queried a
// frozen order, so ANY order reaching it permanently disabled kill-switch auto-resume (crashRecovery
// .hasUnresolvedOrders() — recovery-coordinator.service.ts — never clears). One re-query per frozen
// order per interval: this runs on the same 1s tick() as every *_UNKNOWN poll, and a real deployment
// can have dozens of frozen orders across 40 symbols, so it must never hammer the venue every tick.
const RECONCILE_REQUERY_INTERVAL_MS = 60_000;

// 2026-07-30 defect fix (WATCH-V4-6): NEW was the second permanent trap. `SUBMIT_UNKNOWN +
// QUERY_NOT_FOUND → NEW` is deliberate ("resubmit-eligible", reducer.ts) but the resubmit
// orchestration onNotFound's own comment promised was never built, and sync() only ever tracks
// *_UNKNOWN — so nothing re-queried such an order, nothing re-examined its TTL (evaluated once, ~7s
// after submit, when it is obviously still live) and nothing resubmitted it. Four rows had been
// non-terminal since 2026-07-24 on exactly that chain. Same bounded, rate-limited shape as the
// RECONCILE_REQUIRED sweep above: one re-query per order per interval, off the same 1s tick.
const STRANDED_NEW_REQUERY_INTERVAL_MS = 60_000;

// Age floor an order must clear before this sweep will even consider it, measured from the intent's
// createdAt. The intent TTL alone is NOT a sufficient bound: expiresAt is signal.ttlMs, a
// strategy-tunable knob that can legitimately be a few seconds, while a venue's order-query endpoint
// can lag its own matching engine. Anchoring the floor here keeps the terminalization window
// independent of that knob and orders of magnitude beyond any query-visibility lag.
const STRANDED_NEW_MIN_AGE_MS = 300_000;

// Mirrors mapVenueStatus's own status semantics below (canceled/rejected/expired/closed cases,
// resolveOne's regular-rail switch) — not a second mapping, just the terminal-only subset of it.
// 'open' has no terminal counterpart: a still-resting order proves nothing, so it stays frozen.
function reconcileTerminalFor(
  status: ExchangeOrderState['status'],
): 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED' | undefined {
  switch (status) {
    case 'canceled':
      return 'CANCELED';
    case 'rejected':
      return 'REJECTED';
    case 'expired':
      return 'EXPIRED';
    case 'closed':
      return 'FILLED'; // reduce()'s own FAIL-CLOSED guard rejects this unless cumQty already ≥ qty
    case 'open':
      return undefined;
  }
}

// Backfill floor for an unknown registered WITHOUT any intent behind it (neither in-flight nor
// durable — see resolveTracking). The normal floor is the intent's createdAt; with no intent there
// is no order-specific timestamp to anchor on, and anchoring on the discovery tick would be WRONG in
// the one direction that matters: a boot-recovered order was placed BEFORE this process started, so
// a discovery-time floor would hide its own fills from fetchMyTrades and leave a filled order
// polling until the 60s kill-switch backstop. A wide overlap costs nothing (I3 dedupe makes every
// re-ingested trade a no-op), so the window is deliberately far longer than any plausible
// crash-to-restart gap.
const NO_INTENT_BACKFILL_LOOKBACK_MS = 86_400_000;

type UnknownKind = 'submit' | 'cancel';

interface Pending {
  readonly coid: ClientOrderId;
  readonly symbol: SymbolId;
  readonly kind: UnknownKind;
  attempts: number;
  nextDueAt: number;
  readonly firstUnknownAt: number;
  // fetchMyTrades floor for backfillFills, resolved ONCE at registration. Held here rather than
  // re-read per poll because the intent behind it may live only in the durable store (an async read
  // has no place on the per-poll path) or may not exist at all.
  readonly since: EpochMs;
  // Registration-time rail classification, for the same reason `since` is captured: resolveOne can
  // only re-derive it from the in-flight map, which a store-only intent never enters.
  readonly algoRail: boolean;
  cancelReissues: number;
  escalated: boolean; // 60s kill-switch backstop fired for this order
}

// §6.1/§6.3 query loop for the ambiguous states. SUBMITTING failures degrade to SUBMIT_UNKNOWN and
// cancel ambiguities to CANCEL_UNKNOWN; this resolver discovers them, polls venue truth on the
// 250/500/1s/2s/4s ±20% schedule, and folds the result through the SAME idempotent pipelines the
// stream uses (fills via FillIngestor, then the status event). Three escalations enforce the
// money-safety invariant "when the state of real money is unknown, nothing else trades":
//   • a query that fetchMyTrades-backfills fills BEFORE folding the status (cumQty is rebuilt from
//     the fill table, never the venue's running field);
//   • bounded attempts (or >3 cancel reissues) inconclusive ⇒ RECONCILE_REQUIRED + frozen symbol +
//     full-qty exposure left reserved;
//   • any unknown unresolved >60s, or fatal-auth on the query, ⇒ the global kill switch.
// Time is explicit: tick(now) reads the clock — no sleeps — so the whole loop is virtual-time
// deterministic in tests, the cron wrapper a thin untested caller.
@Injectable()
export class UnknownResolverService {
  private readonly pending = new Map<string, Pending>();
  private readonly frozen = new Set<string>();
  private readonly rng = mulberry32(JITTER_SEED);
  private readonly log = new Logger(UnknownResolverService.name);
  // clientOrderId -> next allowed re-query, for the RECONCILE_REQUIRED sweep only (separate from
  // `pending`'s *_UNKNOWN backoff schedule — a frozen order is no longer tracked there).
  private readonly reconcileNextQueryAt = new Map<string, EpochMs>();
  // clientOrderId -> next allowed re-query, for the stranded-NEW sweep only. Separate map for the
  // same reason as the one above: a NEW order has no `pending` entry (onNotFound deleted it) and,
  // after a restart, no in-flight intent either — there is no existing tracking set to reuse.
  private readonly strandedNewNextQueryAt = new Map<string, EpochMs>();

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EXCHANGE_PORT) private readonly exchange: ExchangePort,
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitchPort,
    private readonly orders: OrderBookService,
    private readonly portfolio: PortfolioStateService,
    private readonly ingestor: FillIngestorService,
  ) {}

  // True while the symbol has an order frozen at RECONCILE_REQUIRED (worst-case exposure reserved).
  isFrozen(symbol: SymbolId): boolean {
    return this.frozen.has(symbol);
  }

  trackedCount(): number {
    return this.pending.size;
  }

  // Cron-driven each cycle. Auto-discovers newly-unknown orders, drops resolved ones, enforces the
  // 60s backstop, then polls every entry whose backoff is due.
  async tick(now: EpochMs): Promise<void> {
    await this.sync(now);
    for (const p of [...this.pending.values()]) {
      if (!p.escalated && now - p.firstUnknownAt > UNKNOWN_KILL_AFTER_MS) {
        p.escalated = true;
        this.killSwitch.engage('UNKNOWN_UNRESOLVED_60S', false); // cannot flatten on unknown state
      }
      if (now >= p.nextDueAt) await this.resolveOne(p, now);
    }
    await this.reconcileFrozen(now);
    await this.sweepStrandedNew(now);
  }

  // Reconcile the tracking set with the order book: register fresh unknowns, forget any an
  // out-of-band stream event already resolved.
  private async sync(now: EpochMs): Promise<void> {
    for (const rec of this.orders.all()) {
      const isUnknown = rec.state === 'SUBMIT_UNKNOWN' || rec.state === 'CANCEL_UNKNOWN';
      const tracked = this.pending.has(rec.clientOrderId);
      if (isUnknown && !tracked) {
        const tracking = await this.resolveTracking(rec, now);
        if (tracking === undefined) continue;
        this.pending.set(rec.clientOrderId, {
          coid: rec.clientOrderId,
          ...tracking,
          kind: rec.state === 'SUBMIT_UNKNOWN' ? 'submit' : 'cancel',
          attempts: 0,
          nextDueAt: now + this.backoff(1),
          firstUnknownAt: now,
          cancelReissues: 0,
          escalated: false,
        });
      } else if (!isUnknown && tracked) {
        this.pending.delete(rec.clientOrderId);
      }
    }
  }

  // Everything registration needs that does not come off the OrderRecord: the symbol to query, the
  // backfill floor, and the rail. Three intent sources in falling order of authority, because a
  // SUBMIT_UNKNOWN can legitimately have NO in-flight intent and, before 2026-08-03, that alone made
  // it permanently untrackable — never polled, never escalated by tick()'s 60s backstop. Boot
  // recovery is the reproducer: a persisted SUBMITTING row is neither venue-confirmed-open nor yet
  // unresolved when boot-recovery.service.ts decides whether to rehydrate its intent, so it does not;
  // CrashRecoveryService.recoverOnBoot() then degrades it to SUBMIT_UNKNOWN AFTER that loop has run.
  // The order was a LIVENESS trap rather than silent money loss — it still reads `isUnresolved`, so
  // it blocked live arming and kill-switch auto-resume forever instead of trading unwatched — but the
  // one invariant that is supposed to end that state (unknown >60s ⇒ kill switch) never applied to it.
  //
  // FAIL DIRECTION: the ONLY remaining skip is "no symbol from any source", where a poll is
  // physically impossible (fetchOrder is keyed by symbol). Deliberately NOT addInFlight: reserving
  // capital for an order that never confirmed landing is the wrong direction, and that policy is
  // boot-recovery's, not this loop's — tracking an order and reserving exposure for it are separate
  // decisions.
  private async resolveTracking(
    rec: OrderRecord,
    now: EpochMs,
  ): Promise<{ symbol: SymbolId; since: EpochMs; algoRail: boolean } | undefined> {
    const intent =
      this.portfolio.inFlightIntent(rec.clientOrderId) ??
      (await this.loadDurableIntent(rec.clientOrderId));
    if (intent !== undefined) {
      return { symbol: intent.symbol, since: intent.createdAt, algoRail: isAlgoRailIntent(intent) };
    }
    if (rec.symbol === undefined) return undefined;
    // Symbol-only: the rail cannot be classified without the intent's triggerPrice, so the order
    // takes the regular rail — the pre-existing behaviour for every order whose intent is missing,
    // and resolveAlgoOne's own "absence proves nothing" refusal is unavailable to us here anyway.
    return {
      symbol: rec.symbol,
      since: Math.max(0, now - NO_INTENT_BACKFILL_LOOKBACK_MS) as EpochMs,
      algoRail: false,
    };
  }

  private async resolveOne(p: Pending, now: EpochMs): Promise<void> {
    // Push 3 P7f fix 2: an algo-rail intent (isAlgoRailIntent) can never be resolved through
    // fetchOrder — that is the REGULAR rail, and a perp STOP_MARKET 404s there (-2013 →
    // OrderNotFound), which the regular-rail branch below would read as a genuine not-found and
    // FALSELY retire the pending entry on the first poll, bypassing the rule-5 60s kill-switch
    // watchdog while a phantom reserve stays held. Route to the algo-rail's own truth instead.
    // p.algoRail carries the registration-time classification for an order whose intent lives only
    // in the durable store; the live in-flight read still wins when it is available, so an order
    // registered before its intent landed in the map cannot be pinned to the wrong rail.
    const intent = this.portfolio.inFlightIntent(p.coid);
    const algoRail = intent !== undefined ? isAlgoRailIntent(intent) : p.algoRail;
    if (p.kind === 'submit' && algoRail) {
      await this.resolveAlgoOne(p, now);
      return;
    }

    let venue: ExchangeOrderState;
    try {
      venue = await this.exchange.fetchOrder(p.coid, p.symbol);
    } catch (err) {
      await this.onQueryError(p, now, err);
      return;
    }

    // Backfill realized fills first (they may already drive the order terminal); cumQty is rebuilt
    // from the fill table, so this MUST precede any ack/terminal fold. venue.venueOrderId is passed
    // through explicitly (MATCHING, mirrors demo-fill-poller.service.ts): ccxt's unified myTrades
    // carries `order` = the VENUE numeric order id as VenueFill.clientOrderId (Binance has no
    // clientOrderId on myTrades), so a trade for THIS order is found by that id, not by p.coid — the
    // p.coid comparison only ever matches an adapter (paper) that echoes our own clientOrderId.
    if (new Decimal(venue.cumQty).gt(0)) {
      await this.backfillFills(p, venue.venueOrderId);
    }
    if (venue.venueOrderId.length > 0) this.orders.setVenueOrderId(p.coid, venue.venueOrderId);

    // A tracked entry always has its order in the book (sync derives the set from it); the only
    // question is whether the backfill already drove it terminal.
    if (TERMINAL.has(this.orders.get(p.coid)!.state)) {
      this.pending.delete(p.coid); // resolved by the backfilled fills
      return;
    }

    await this.mapVenueStatus(p, now, venue);
  }

  // Push 3 P7f fix 2: the algo rail's own truth for a SUBMIT_UNKNOWN. fetchOpenAlgoOrders is the
  // ONLY positive signal here — a matching clientAlgoId proves the order landed/is resting, folded
  // through the SAME ACK transition a regular-rail 'open' status would (query-confirmed open, see
  // mapVenueStatus's own 'open' arm). Absence proves NOTHING: a triggered, filled, or cancelled
  // algo order also vanishes from the open-algos list, exactly like a regular-rail 'closed'/gone
  // order — so a miss (or an adapter that lacks fetchOpenAlgoOrders, i.e. spot/paper) never
  // resolves anything. Fail direction, explicit: unknown stays unknown; the entry is left pending
  // (nextDueAt only) so tick()'s own firstUnknownAt check is the SOLE backstop — deliberately never
  // routed through defer()'s MAX_QUERY_ATTEMPTS budget, which would freeze to RECONCILE_REQUIRED on
  // an absence that proves nothing (an outcome finding 2 exists specifically to prevent).
  private async resolveAlgoOne(p: Pending, now: EpochMs): Promise<void> {
    let open: readonly AlgoOrderState[];
    try {
      open = (await this.exchange.fetchOpenAlgoOrders?.(p.symbol)) ?? [];
    } catch {
      this.deferAlgoPending(p, now); // transient query failure — retry later, never freezes here
      return;
    }
    const found = open.find((o) => o.clientAlgoId === String(p.coid));
    if (found === undefined) {
      this.deferAlgoPending(p, now); // absence proves nothing on this rail — stays pending
      return;
    }
    if (found.algoId.length > 0) this.orders.setVenueOrderId(p.coid, found.algoId);
    if (this.orders.get(p.coid)!.state === 'SUBMIT_UNKNOWN') {
      await this.fold(p.coid, 'query-algo-ack', { type: 'ACK', venueOrderId: found.algoId });
    }
    this.pending.delete(p.coid);
  }

  // Reschedules the next poll WITHOUT touching the attempt budget (defer()'s own MAX_QUERY_ATTEMPTS
  // freeze) — see resolveAlgoOne's own header comment on why an algo-rail absence must never freeze.
  private deferAlgoPending(p: Pending, now: EpochMs): void {
    p.attempts += 1; // backoff-curve input only, never compared against MAX_QUERY_ATTEMPTS here
    p.nextDueAt = now + this.backoff(p.attempts + 1);
  }

  private async mapVenueStatus(p: Pending, now: EpochMs, venue: ExchangeOrderState): Promise<void> {
    switch (venue.status) {
      case 'open':
        if (p.kind === 'cancel') {
          await this.reissueCancel(p, now); // still resting — re-issue the cancel, bounded
        } else if (this.orders.get(p.coid)!.state === 'SUBMIT_UNKNOWN') {
          // open with cum 0: the order landed but never acked back — fold the explicit ack.
          await this.fold(p.coid, 'query-ack', { type: 'ACK', venueOrderId: venue.venueOrderId });
          this.pending.delete(p.coid);
        } else {
          this.pending.delete(p.coid); // backfill already advanced it past SUBMIT_UNKNOWN
        }
        return;
      case 'canceled':
        await this.fold(
          p.coid,
          'query-canceled',
          p.kind === 'cancel' ? { type: 'CANCEL_ACK' } : { type: 'VENUE_CANCELED' },
        );
        this.pending.delete(p.coid);
        return;
      case 'closed':
        // A "closed" order with no residual is fully filled; backfill should have driven FILLED.
        // If it did not (no trades visible yet), keep polling rather than assert a state.
        await this.defer(p, now);
        return;
      case 'rejected':
        if (p.kind === 'submit') {
          // Defect A commit-1: no venue reason text is available on this path (ExchangeOrderState
          // carries no rejection message) — 'query-rejected' records at least the resolution source.
          await this.fold(p.coid, 'query-rejected', { type: 'REJECT' }, 'query-rejected');
          this.pending.delete(p.coid);
        } else {
          await this.freeze(p, 'query-inconclusive'); // a rejected order we hold a cancel-ack for: contradiction
        }
        return;
      case 'expired':
        if (p.kind === 'submit') {
          await this.fold(p.coid, 'query-expired', { type: 'VENUE_EXPIRED' });
          this.pending.delete(p.coid);
        } else {
          await this.freeze(p, 'query-inconclusive');
        }
        return;
    }
  }

  // fetchOrder threw. AUTH_FATAL is an immediate incident; a definitive not-found resolves per TTL
  // (submit) or freezes (cancel — an order we hold an ack for cannot vanish); anything else is a
  // transient inconclusive attempt subject to the bounded retry budget.
  private async onQueryError(p: Pending, now: EpochMs, err: unknown): Promise<void> {
    const cls = err instanceof AdapterError ? err.errorClass : 'OUTCOME_AMBIGUOUS';
    const code = err instanceof AdapterError ? err.code : 'UNKNOWN';
    if (cls === 'AUTH_FATAL') {
      this.killSwitch.engage(`QUERY_AUTH_FATAL:${code}`, false);
      this.pending.delete(p.coid);
      return;
    }
    if (NOT_FOUND_CODES.has(code)) {
      await this.onNotFound(p);
      return;
    }
    await this.defer(p, now); // transient — back off and retry, freeze when the budget runs out
  }

  private async onNotFound(p: Pending): Promise<void> {
    if (p.kind === 'cancel') {
      await this.freeze(p, 'query-not-found'); // CANCEL_UNKNOWN + not found ⇒ RECONCILE_REQUIRED
      return;
    }
    // SUBMIT_UNKNOWN + definitively-not-found: TTL-live ⇒ NEW (resubmit-eligible, reserve kept);
    // TTL-expired ⇒ CANCELED (fold retires it, releasing the reserve). The reducer keeps the two
    // events distinct precisely so a lapsed intent is never resubmitted on its deterministic id.
    const intent = this.portfolio.inFlightIntent(p.coid);
    const expired = intent === undefined || this.clock.now() > intent.expiresAt;
    await this.fold(p.coid, expired ? 'query-not-found-expired' : 'query-not-found', {
      type: expired ? 'QUERY_NOT_FOUND_EXPIRED' : 'QUERY_NOT_FOUND',
    });
    // NEW is resubmit-eligible; resubmit orchestration is still a follow-up. What is no longer
    // outstanding is the dead end that absence created (WATCH-V4-6): sweepStrandedNew re-examines
    // the order every interval and terminalizes it only once never-landed is positively established.
    this.pending.delete(p.coid);
  }

  private async reissueCancel(p: Pending, now: EpochMs): Promise<void> {
    if (p.cancelReissues >= MAX_CANCEL_REISSUES) {
      await this.freeze(p, 'query-inconclusive'); // >3 reissues, still open ⇒ RECONCILE_REQUIRED
      return;
    }
    p.cancelReissues += 1;
    try {
      await this.exchange.cancelOrder(p.coid, p.symbol);
    } catch {
      // The cancel ack (or the next query) resolves it; a throw here just defers to the retry.
    }
    await this.defer(p, now);
  }

  // An inconclusive poll: count it against the bounded retry budget and back off, or freeze to
  // RECONCILE_REQUIRED once the budget is exhausted.
  private async defer(p: Pending, now: EpochMs): Promise<void> {
    p.attempts += 1;
    if (p.attempts >= MAX_QUERY_ATTEMPTS) {
      await this.freeze(p, 'query-inconclusive');
      return;
    }
    p.nextDueAt = now + this.backoff(p.attempts + 1);
  }

  // QUERY_INCONCLUSIVE ⇒ RECONCILE_REQUIRED. The symbol is frozen and the in-flight intent stays,
  // reserving worst-case exposure until reconciliation or an operator resolves it.
  private async freeze(p: Pending, dedupeKey: string): Promise<void> {
    await this.fold(p.coid, dedupeKey, { type: 'QUERY_INCONCLUSIVE' });
    this.frozen.add(p.symbol);
    this.pending.delete(p.coid);
  }

  // 2026-07-27 defect fix: the bounded, rate-limited re-query pass that ends RECONCILE_REQUIRED's
  // previous permanence. Scans the WHOLE order book (frozen orders have no Pending entry, unlike
  // *_UNKNOWN) rather than a second tracking set — RECONCILE_REQUIRED is rare enough that an O(n)
  // scan per tick is not a concern, and it avoids a second registration/desync path to maintain.
  private async reconcileFrozen(now: EpochMs): Promise<void> {
    // Drop bookkeeping for anything resolved out-of-band (e.g. a stream fill completing it while
    // frozen) — mirrors sync()'s own "forget what an out-of-band event already resolved" cleanup,
    // so this map never grows unbounded over a long-running process.
    for (const coid of this.reconcileNextQueryAt.keys()) {
      if (this.orders.get(coid as ClientOrderId)?.state !== 'RECONCILE_REQUIRED') {
        this.reconcileNextQueryAt.delete(coid);
      }
    }
    for (const rec of this.orders.all()) {
      if (rec.state !== 'RECONCILE_REQUIRED') continue;
      const due = this.reconcileNextQueryAt.get(rec.clientOrderId);
      if (due === undefined) {
        // First sighting: register only, mirroring sync()'s *_UNKNOWN registration — a freeze() a
        // few lines up THIS SAME tick must never be immediately re-queried (the rejected/expired
        // "contradiction" freezes rely on that gap staying real, not a same-tick round trip back to
        // the venue). The rate-limit clock starts from discovery, exactly like the *_UNKNOWN backoff.
        this.reconcileNextQueryAt.set(
          rec.clientOrderId,
          (now + RECONCILE_REQUERY_INTERVAL_MS) as EpochMs,
        );
        continue;
      }
      if (now < due) continue;
      this.reconcileNextQueryAt.set(
        rec.clientOrderId,
        (now + RECONCILE_REQUERY_INTERVAL_MS) as EpochMs,
      );
      await this.reconcileOne(rec);
    }
  }

  // One frozen order's re-query. Fail CLOSED on every ambiguous outcome — no intent (cannot resolve
  // the symbol to query), a throwing/erroring fetchOrder, a non-terminal venue status, or the
  // reducer's own FILLED-short-cumQty guard rejecting the adoption — all leave the order frozen for
  // the next interval, logged at WARN (naturally rate-limited: this only runs once per interval per
  // order, per reconcileFrozen's own gate above).
  private async reconcileOne(rec: OrderRecord): Promise<void> {
    const intent = this.portfolio.inFlightIntent(rec.clientOrderId);
    if (intent === undefined) {
      this.log.warn(`reconcile-adopt ${rec.clientOrderId}: no in-flight intent, staying frozen`);
      return;
    }
    let venue: ExchangeOrderState;
    try {
      venue = await this.exchange.fetchOrder(rec.clientOrderId, intent.symbol);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`reconcile-adopt ${rec.clientOrderId}: query failed (${msg}), staying frozen`);
      return;
    }
    const terminal = reconcileTerminalFor(venue.status);
    if (terminal === undefined) {
      this.log.warn(
        `reconcile-adopt ${rec.clientOrderId}: venue still ${venue.status}, staying frozen`,
      );
      return;
    }
    try {
      reduce(rec, { type: 'RECONCILE_ADOPT_TERMINAL', terminal }); // pre-check: never fold an illegal transition
    } catch (err) {
      /* v8 ignore next -- the String(err) arm is unreachable: this try block calls only reduce(), which throws exclusively TransitionError (extends Error); the ternary exists solely to narrow `unknown` for the type-checker */
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `reconcile-adopt ${rec.clientOrderId}: adoption rejected (${msg}), staying frozen`,
      );
      return;
    }
    const { applied } = await this.fold(rec.clientOrderId, 'reconcile-adopt', {
      type: 'RECONCILE_ADOPT_TERMINAL',
      terminal,
    });
    if (!applied) return; // journal said duplicate — leave frozen, retry next interval
    this.reconcileNextQueryAt.delete(rec.clientOrderId);
    this.unfreezeIfClear(intent.symbol);
  }

  // 2026-07-30 WATCH-V4-6 fix: the missing sweep over orders stranded at NEW. Whole-book scan for
  // the same reason reconcileFrozen does one — these orders carry no Pending entry — plus one more:
  // boot recovery re-seeds them into the book on every restart, so the sweep must find them from the
  // book alone, with no runtime registration behind them.
  private async sweepStrandedNew(now: EpochMs): Promise<void> {
    for (const coid of this.strandedNewNextQueryAt.keys()) {
      if (this.orders.get(coid as ClientOrderId)?.state !== 'NEW') {
        this.strandedNewNextQueryAt.delete(coid);
      }
    }
    for (const rec of this.orders.all()) {
      if (rec.state !== 'NEW') continue;
      const due = this.strandedNewNextQueryAt.get(rec.clientOrderId);
      if (due === undefined) {
        // First sighting registers only, mirroring reconcileFrozen and sync(). Load-bearing here:
        // execution-gate.service.ts's submit() straddles an await between orders.create() (state
        // NEW) and the SUBMIT_SENT fold, so a tick CAN observe a healthy order mid-submit — it must
        // never be examined on the tick that first sees it. The age floor below independently
        // excludes that order too — this is the second of the two guards, not the only one.
        this.strandedNewNextQueryAt.set(
          rec.clientOrderId,
          (now + STRANDED_NEW_REQUERY_INTERVAL_MS) as EpochMs,
        );
        continue;
      }
      if (now < due) continue;
      this.strandedNewNextQueryAt.set(
        rec.clientOrderId,
        (now + STRANDED_NEW_REQUERY_INTERVAL_MS) as EpochMs,
      );
      await this.resolveStrandedNew(rec, now);
    }
  }

  // One stranded-NEW order's terminalization decision.
  //
  // FAILURE DIRECTION: CLOSED, and deliberately asymmetric. This is an irreversible-action gate —
  // order_events is append-only, so a CANCELED folded onto an order that actually filled can never
  // be walked back, and the book would then silently carry an unmanaged position. An order left at
  // NEW is merely untidy: it holds no venue-side exposure, reserves no capital once its intent is
  // gone, and is not `isUnresolved`, so it blocks neither live arming nor kill-switch auto-resume.
  // Terminalizing therefore demands POSITIVE evidence of never-landed on every axis; absence of
  // evidence, an unreadable store, a venue that answers at all, or a query that merely fails all
  // leave the order exactly where it is, to be re-examined next interval.
  //
  // The four required facts, each independently capable of refusing:
  //   1. no venueOrderId was ever recorded — we never held an ack naming this order;
  //   2. the DURABLE fill journal (not the in-memory cum) sums to zero for this clientOrderId;
  //   3. a durable intent exists, its TTL has lapsed, and the order clears the age floor;
  //   4. a FRESH re-query still answers a DEFINITIVE not-found — hard rule 5's query-first, because
  //      the original QUERY_NOT_FOUND that stranded the order is days stale by the time we get here.
  // A re-query that RESOLVES with any status — including 'open' — is proof the order landed, so the
  // sweep refuses. That contradiction belongs to reconciliation's UNKNOWN_OURS_OPEN halt, not here;
  // this sweep never places, cancels, adopts or flattens anything at the venue. An AUTH_FATAL on the
  // re-query likewise only refuses: the *_UNKNOWN query loop above owns kill-switch escalation, and
  // a measurement sweep must not gain a second trigger for it.
  //
  // The fold is CANCEL_REQUESTED on NEW ("never sent, local-only", reducer.ts) — an existing, already
  // audited transition, so no reducer change — written as a NEW append-only order_events row.
  private async resolveStrandedNew(rec: OrderRecord, now: EpochMs): Promise<void> {
    const coid = rec.clientOrderId;
    const refuse = (why: string): void => {
      this.log.warn(`stranded-new ${coid}: ${why} — staying NEW`);
    };
    if (rec.venueOrderId !== undefined) {
      refuse('a venueOrderId is recorded, so the venue once named this order');
      return;
    }
    if (!rec.cumQty.isZero()) {
      refuse(`cumQty is ${rec.cumQty.toFixed()}`);
      return;
    }
    const intent = this.portfolio.inFlightIntent(coid) ?? (await this.loadDurableIntent(coid));
    if (intent === undefined) {
      refuse('no durable intent, so neither its symbol nor its age can be established');
      return;
    }
    // Not yet eligible is the ordinary state of a healthy young order, not an anomaly — no WARN.
    if (now <= intent.expiresAt || now - intent.createdAt <= STRANDED_NEW_MIN_AGE_MS) return;

    let journaled: Decimal;
    try {
      journaled = new Decimal(await this.store.loadFilledQty(coid));
    } catch (err) {
      refuse(`fill-journal read failed (${String(err)})`);
      return;
    }
    if (journaled.gt(0)) {
      refuse(`the fill journal holds ${journaled.toFixed()} for it`);
      return;
    }

    try {
      const venue = await this.exchange.fetchOrder(coid, intent.symbol);
      refuse(`the venue answers '${venue.status}', so the order landed after all`);
      return;
    } catch (err) {
      const code = err instanceof AdapterError ? err.code : 'UNKNOWN';
      if (!NOT_FOUND_CODES.has(code)) {
        refuse(`re-query inconclusive (${code})`);
        return;
      }
    }
    await this.fold(
      coid,
      'stranded-new-not-found',
      { type: 'CANCEL_REQUESTED' },
      'STRANDED_NEW_NEVER_LANDED',
    );
    this.log.log(
      `stranded-new ${coid}: venue not-found on re-query, zero journaled fills, no ack — locally canceled`,
    );
  }

  // The durable write-ahead intent for an order the in-memory in-flight map no longer holds. Boot
  // recovery deliberately does NOT rehydrate intents for NEW rows (boot-recovery.service.ts: an
  // order that never confirmed landing must not reserve capital), which is precisely why a stranded
  // NEW order has none after a restart — and why this read, rather than the in-flight map, is what
  // lets the sweep work across boots at all. A store that never wired the optional read, a missing
  // row, or a throwing read all resolve `undefined`, and the caller refuses (fail closed).
  private async loadDurableIntent(coid: ClientOrderId): Promise<OrderIntent | undefined> {
    try {
      return (await this.store.loadIntentByClientOrderId?.(coid)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  // Only unfreeze a symbol once NO order for it is still RECONCILE_REQUIRED — never on the first
  // order to clear (never place/cancel/flatten anything here, purely a local bookkeeping check).
  private unfreezeIfClear(symbol: SymbolId): void {
    const stillFrozen = this.orders.all().some((r) => {
      if (r.state !== 'RECONCILE_REQUIRED') return false;
      return this.portfolio.inFlightIntent(r.clientOrderId)?.symbol === symbol;
    });
    if (!stillFrozen) this.frozen.delete(symbol);
  }

  // Fold one resolver-derived event: pure reduce → journal (idempotent on the dedupe key) → commit
  // only if the journal accepted it (replay-safe) → retire on a terminal. Takes a bare coid (rather
  // than a Pending) so the RECONCILE_REQUIRED sweep can reuse it too — a frozen order has no Pending
  // entry (freeze() already deleted it). The order is always in the book, so the read is unconditional.
  // Returns `applied` so a caller that must react to a duplicate-skip (reconcileOne) can — every
  // pre-existing call site ignores it, exactly as before.
  private async fold(
    coid: ClientOrderId,
    dedupeKey: string,
    event: OrderEvent,
    reason?: string,
  ): Promise<{ applied: boolean }> {
    const next = reduce(this.orders.get(coid)!, event);
    const { applied } = await this.store.appendOrderEvent({
      clientOrderId: coid,
      dedupeKey,
      event,
      derivedState: next.state,
      cumQty: next.cumQty.toFixed(),
      venueOrderId: next.venueOrderId,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (!applied) return { applied: false };
    this.orders.commit(next);
    if (TERMINAL.has(next.state)) {
      this.portfolio.clearInFlight(coid);
      this.portfolio.closeOrder(coid);
    }
    return { applied: true };
  }

  // Sweep realized trades since the intent was created (a wide overlap is free under I3 dedupe) and
  // ingest each through the shared FillIngestor; duplicates apply nothing. The floor is resolved at
  // registration (see resolveTracking) — reading the in-flight map here instead would throw on the
  // intent-less orders this loop now tracks.
  private async backfillFills(p: Pending, venueOrderId: string): Promise<void> {
    const since = p.since;
    let trades: readonly VenueFill[];
    try {
      trades = await this.exchange.fetchMyTrades(p.symbol, since);
    } catch {
      return; // backfill is best-effort here; the status fold / next tick still progresses safety
    }
    let rec = this.orders.get(p.coid)!;
    for (const t of trades) {
      // A trade is ours iff it echoes our own coid (paper) OR carries THIS order's venue order id
      // (ccxt myTrades — see resolveOne's own comment on the call site above); neither ⇒ a sibling
      // order's trade on the same symbol, skipped.
      const isOurs =
        t.clientOrderId === p.coid || (venueOrderId.length > 0 && t.clientOrderId === venueOrderId);
      if (!isOurs) continue;
      const res = await this.ingestor.ingest(
        rec,
        this.toFillRecord(t, p.coid),
        `query:${t.venueTradeId}`,
      );
      rec = res.record;
    }
  }

  private toFillRecord(t: VenueFill, coid: ClientOrderId): FillRecord {
    return {
      venue: t.venue,
      symbol: t.symbol,
      venueTradeId: t.venueTradeId,
      clientOrderId: coid,
      price: price(t.price),
      qty: qty(t.qty),
      fee: t.fee ? { ccy: t.fee.ccy, amount: feeAmount(t.fee.amount) } : null,
      liquidity: t.liquidity,
      venueTimestamp: t.venueTimestamp,
      source: 'rest_reconcile',
    };
  }

  private backoff(attempt: number): number {
    return queryBackoffMs(attempt, this.rng());
  }
}
