import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../ports/clock';
import { KILL_SWITCH, type KillSwitchPort } from '../../ports/risk';
import {
  EXCHANGE_PORT,
  AdapterError,
  type ExchangePort,
  type ExchangeOrderState,
  type VenueFill,
} from '../../ports/exchange';
import { EXECUTION_STORE, type ExecutionStorePort } from '../../ports/execution';
import { reduce, type OrderEvent, type OrderState } from '../../domain/oms/reducer';
import { mulberry32 } from '../../domain/strategy/prng';
import {
  queryBackoffMs,
  MAX_QUERY_ATTEMPTS,
  UNKNOWN_KILL_AFTER_MS,
} from '../../domain/oms/query-backoff';
import { price, qty, feeAmount } from '../../domain/types/money';
import type { ClientOrderId, SymbolId, EpochMs } from '../../domain/types/ids';
import type { FillRecord } from '../../domain/types/exec-report';
import { OrderBookService } from './order-book.service';
import { PortfolioStateService } from './portfolio-state.service';
import { FillIngestorService } from './fill-ingestor.service';

const TERMINAL: ReadonlySet<OrderState> = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(['OrderNotFound', 'ORDER_NOT_FOUND']);
const MAX_CANCEL_REISSUES = 3; // §6.1: >3 cancel reissues while still open ⇒ RECONCILE_REQUIRED
const JITTER_SEED = 0x5165_5279; // fixed ⇒ the ±20% backoff jitter replays deterministically

type UnknownKind = 'submit' | 'cancel';

interface Pending {
  readonly coid: ClientOrderId;
  readonly symbol: SymbolId;
  readonly kind: UnknownKind;
  attempts: number;
  nextDueAt: number;
  readonly firstUnknownAt: number;
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
    this.sync(now);
    for (const p of [...this.pending.values()]) {
      if (!p.escalated && now - p.firstUnknownAt > UNKNOWN_KILL_AFTER_MS) {
        p.escalated = true;
        this.killSwitch.engage('UNKNOWN_UNRESOLVED_60S', false); // cannot flatten on unknown state
      }
      if (now >= p.nextDueAt) await this.resolveOne(p, now);
    }
  }

  // Reconcile the tracking set with the order book: register fresh unknowns (symbol + TTL come from
  // the retained in-flight intent), forget any an out-of-band stream event already resolved.
  private sync(now: EpochMs): void {
    for (const rec of this.orders.all()) {
      const isUnknown = rec.state === 'SUBMIT_UNKNOWN' || rec.state === 'CANCEL_UNKNOWN';
      const tracked = this.pending.has(rec.clientOrderId);
      if (isUnknown && !tracked) {
        const intent = this.portfolio.inFlightIntent(rec.clientOrderId);
        if (intent === undefined) continue; // exposure is reserved via the intent; without it we cannot poll
        this.pending.set(rec.clientOrderId, {
          coid: rec.clientOrderId,
          symbol: intent.symbol,
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

  private async resolveOne(p: Pending, now: EpochMs): Promise<void> {
    let venue: ExchangeOrderState;
    try {
      venue = await this.exchange.fetchOrder(p.coid, p.symbol);
    } catch (err) {
      await this.onQueryError(p, now, err);
      return;
    }

    // Backfill realized fills first (they may already drive the order terminal); cumQty is rebuilt
    // from the fill table, so this MUST precede any ack/terminal fold.
    if (new Decimal(venue.cumQty).gt(0)) {
      await this.backfillFills(p);
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

  private async mapVenueStatus(p: Pending, now: EpochMs, venue: ExchangeOrderState): Promise<void> {
    switch (venue.status) {
      case 'open':
        if (p.kind === 'cancel') {
          await this.reissueCancel(p, now); // still resting — re-issue the cancel, bounded
        } else if (this.orders.get(p.coid)!.state === 'SUBMIT_UNKNOWN') {
          // open with cum 0: the order landed but never acked back — fold the explicit ack.
          await this.fold(p, 'query-ack', { type: 'ACK', venueOrderId: venue.venueOrderId });
          this.pending.delete(p.coid);
        } else {
          this.pending.delete(p.coid); // backfill already advanced it past SUBMIT_UNKNOWN
        }
        return;
      case 'canceled':
        await this.fold(
          p,
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
          await this.fold(p, 'query-rejected', { type: 'REJECT' });
          this.pending.delete(p.coid);
        } else {
          await this.freeze(p, 'query-inconclusive'); // a rejected order we hold a cancel-ack for: contradiction
        }
        return;
      case 'expired':
        if (p.kind === 'submit') {
          await this.fold(p, 'query-expired', { type: 'VENUE_EXPIRED' });
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
    await this.fold(p, expired ? 'query-not-found-expired' : 'query-not-found', {
      type: expired ? 'QUERY_NOT_FOUND_EXPIRED' : 'QUERY_NOT_FOUND',
    });
    this.pending.delete(p.coid); // NEW is resubmit-eligible; resubmit orchestration is a follow-up
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
    await this.fold(p, dedupeKey, { type: 'QUERY_INCONCLUSIVE' });
    this.frozen.add(p.symbol);
    this.pending.delete(p.coid);
  }

  // Fold one resolver-derived event: pure reduce → journal (idempotent on the dedupe key) → commit
  // only if the journal accepted it (replay-safe) → retire on a terminal. A tracked entry's order
  // is always in the book, so the record is read unconditionally.
  private async fold(p: Pending, dedupeKey: string, event: OrderEvent): Promise<void> {
    const next = reduce(this.orders.get(p.coid)!, event);
    const { applied } = await this.store.appendOrderEvent({
      clientOrderId: p.coid,
      dedupeKey,
      event,
      derivedState: next.state,
      cumQty: next.cumQty.toFixed(),
      venueOrderId: next.venueOrderId,
    });
    if (!applied) return;
    this.orders.commit(next);
    if (TERMINAL.has(next.state)) {
      this.portfolio.clearInFlight(p.coid);
      this.portfolio.closeOrder(p.coid);
    }
  }

  // Sweep realized trades since the intent was created (a wide overlap is free under I3 dedupe) and
  // ingest each through the shared FillIngestor; duplicates apply nothing. The in-flight intent is
  // retained for every non-terminal tracked order, so its createdAt is the checkpoint floor.
  private async backfillFills(p: Pending): Promise<void> {
    const since = this.portfolio.inFlightIntent(p.coid)!.createdAt;
    let trades: readonly VenueFill[];
    try {
      trades = await this.exchange.fetchMyTrades(p.symbol, since);
    } catch {
      return; // backfill is best-effort here; the status fold / next tick still progresses safety
    }
    let rec = this.orders.get(p.coid)!;
    for (const t of trades) {
      if (t.clientOrderId !== p.coid) continue; // a trade for a sibling order on the same symbol
      const res = await this.ingestor.ingest(rec, this.toFillRecord(t), `query:${t.venueTradeId}`);
      rec = res.record;
    }
  }

  private toFillRecord(t: VenueFill): FillRecord {
    return {
      venue: t.venue,
      symbol: t.symbol,
      venueTradeId: t.venueTradeId,
      clientOrderId: t.clientOrderId,
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
