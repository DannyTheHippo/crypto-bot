import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { SymbolId } from '../../../domain/common/types/ids';
import { epochMs } from '../../../domain/common/types/ids';
import { splitSymbol } from '../../../domain/venue/types/symbol';
import type { ClockPort } from '../../../ports/common/clock';
import type {
  LiquidationFeedPort,
  LiquidationSnapshot,
} from '../../../ports/venue/liquidation-feed';

// Rolling window default (minutes) — a constant, not an env knob (v0; mirrors V2_LOOKBACK_MS's own
// "knob-free" rationale in derivatives-feed.service.ts — no per-deployment tuning needed yet).
const DEFAULT_WINDOW_MIN = 60;
// Reconnect backoff after a caught stream error — mirrors ccxt-stream.adapter.ts's own backoff().
const DEFAULT_BACKOFF_MS = 1000;
// "Healthy but recording nothing" alarm threshold (defect-145): a keying mismatch between
// subscription and storage silently zeroed this feed's windows for weeks before anyone noticed,
// because a healthy stream with zero events is indistinguishable from a healthy, genuinely quiet
// market without an explicit check. Not an env knob, mirrors DEFAULT_WINDOW_MIN's own
// no-per-deployment-tuning rationale.
const ZERO_EVENT_WARN_MS = 30 * 60_000;

// One parsed liquidation event this service needs — deliberately narrow (not ccxt's full Liquidation
// structure) so tests supply a fixture double instead of a live exchange (mirrors WatchSource in
// ccxt-stream.adapter.ts). `symbol` arrives in ccxt's unified PERP form (e.g. 'BTC/USDT:USDT').
// `side` is the FORCED order's side: 'sell' liquidates a LONG position (forced sell to close it),
// 'buy' liquidates a SHORT position (forced buy to close it) — Binance forceOrder semantics. Typed
// as plain `string` (ccxt's own safeStringLower coercion gives no stronger runtime guarantee) — the
// record() mapping below only ever branches on `=== 'buy'`, treating anything else as 'sell'/long.
export interface LiquidationEvent {
  readonly symbol: string;
  readonly side: string;
  // Notional in quote currency (USDT) — ccxt's safeLiquidation computes this as contracts *
  // contractSize * price when the market's contractSize is known; falls back to contracts * price
  // when absent (see toNotionalUsd below).
  readonly quoteValue?: number;
  readonly contracts?: number;
  readonly price?: number;
  readonly timestamp?: number;
}

/** Minimal ccxt PRO watch surface this service needs — injected so tests supply a fixture double
 * instead of a live WS connection (mirrors WatchSource in ccxt-stream.adapter.ts). A single call
 * resolves with one or more events once the venue pushes a forceOrder message; it does not resolve
 * on a benign keepalive, so "no event yet" is never itself an error (see the class header). */
export interface LiquidationWatchSource {
  watchLiquidationsForSymbols(symbols: readonly string[]): Promise<readonly LiquidationEvent[]>;
}

// BASE/QUOTE (spot, e.g. BTC/USDT) -> BASE/QUOTE:QUOTE (ccxt's linear-swap perp form) — the SAME
// mapping convention derivatives-feed.service.ts's perpSymbolFor uses (each feed file keeps its own
// local copy rather than a cross-file import, matching that file's own convention). Liquidations are
// a perp-only concept (spot has no forced-liquidation mechanism). Idempotent on an already-perp
// SymbolId whose settle === quote (splitSymbol discards a pre-existing :settle suffix and this
// rebuilds it from quote — for settle !== quote, e.g. 'BTC/USD:BTC', the rebuild yields 'BTC/USD:USD',
// not the original), so it is the single normalization point for both a spot-form and a perp-form
// caller within this file's linear-swap universe (defect-145: the
// prior design converted the ccxt event to spot form instead, which diverged from a perp-form
// configured basket and silently dropped every event — see the class header below).
function perpSymbolFor(symbol: SymbolId): string {
  const { base, quote } = splitSymbol(symbol);
  return `${base}/${quote}:${quote}`;
}

function asFiniteNumber(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Notional in quote currency for one event — prefers the venue/ccxt-computed quoteValue; falls back
// to contracts * price when quoteValue is absent (e.g. a fixture double, or a market whose
// contractSize ccxt could not resolve). 0 (never null) when neither is computable — an unpriced event
// still counts toward `count` but contributes no notional, rather than corrupting the whole snapshot.
function toNotionalUsd(ev: LiquidationEvent): number {
  const quoteValue = asFiniteNumber(ev.quoteValue);
  if (quoteValue !== null) return quoteValue;
  const contracts = asFiniteNumber(ev.contracts);
  const price = asFiniteNumber(ev.price);
  return contracts !== null && price !== null ? contracts * price : 0;
}

interface LiqSample {
  readonly ts: number;
  readonly notionalUsd: number;
  // 'long' when a LONG position was liquidated (forced sell), 'short' when a SHORT was (forced buy).
  readonly side: 'long' | 'short';
}

export interface LiquidationFeedOptions {
  readonly symbols: readonly SymbolId[];
  readonly clock: ClockPort;
  readonly windowMin?: number;
  readonly backoffMs?: number;
  readonly logger?: { warn: (msg: string) => void };
}

/**
 * WS-stream service for public liquidation-order flow (rolling notional + long/short side-skew) —
 * feature-flagged OFF by default (AGENTIC_LIQUIDATIONS_ENABLED), consumed by the agentic prompt via
 * LiquidationFeedPort. Subscribes ONCE to every configured symbol's perp market via
 * watchLiquidationsForSymbols and runs a single supervised loop (mirrors CcxtExchangeStreamAdapter's
 * per-channel loops in ccxt-stream.adapter.ts, scaled down to one channel): a caught error marks the
 * stream unhealthy, backs off, and retries — it never throws out of the loop, and never blocks/delays
 * any order-path caller (CLAUDE.md rule 5's OMS caution does not apply — no network call this service
 * makes is ever awaited by a decide()/order path).
 *
 * Rolling windows are keyed by the ccxt unified PERP string (e.g. 'BTC/USDT:USDT') throughout, via
 * perpSymbolFor — the one form both the WS event and a caller's configured/queried SymbolId (spot or
 * perp) normalize to. defect-145: an earlier version stored under a spot-converted key while the
 * composition root configures/subscribes in perp form, which meant record()'s own membership check
 * (and, independently, its storage key) never matched what a real deployment configures — every
 * event was silently dropped, and the feed answered a permanent, plausible-looking zero.
 */
@Injectable()
export class LiquidationFeedService implements LiquidationFeedPort, OnModuleInit, OnModuleDestroy {
  private running = false;
  // Optimistically true the moment the loop starts (see start()) — there is no observable
  // "still connecting" state distinct from "running, no event yet" over a single watch() call, so a
  // freshly started stream with zero events is HEALTHY, not stale (the brief's own distinction).
  private healthy = false;
  private reconnects = 0;
  private readonly windows = new Map<string, LiqSample[]>();
  // Perp-form subscription index (see perpSymbolFor) — the single source record() AND latest() check
  // membership against, so a spot- or perp-form entry in options.symbols always resolves to the same
  // key. Mutable: runLoop() deletes an entry here when the venue rejects it as unlisted (see the
  // "does not have market symbol" branch below) — a pruned symbol must answer latest() with null, the
  // same as one this deployment never configured, never a fabricated zero (defect-145's own shape:
  // 12 of 40 configured symbols have no perp sibling in the basket and must never look "quiet").
  private readonly subscribed: Set<string>;
  // Post-membership-filter event count (defect-145 observability gap: a healthy stream recording
  // zero events for weeks had no signal distinguishing it from a genuinely quiet market).
  private recordedEvents = 0;
  private healthySinceMs: number | null = null;
  private warnedZeroEvents = false;

  constructor(
    private readonly source: LiquidationWatchSource,
    private readonly options: LiquidationFeedOptions,
  ) {
    this.subscribed = new Set(this.options.symbols.map((s) => perpSymbolFor(s)));
  }

  onModuleInit(): void {
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.healthy = true;
    this.healthySinceMs = this.options.clock.now();
    this.warnedZeroEvents = false;
    void this.runLoop();
  }

  stop(): void {
    this.running = false;
  }

  onModuleDestroy(): void {
    this.stop();
  }

  streamHealthy(): boolean {
    return this.running && this.healthy;
  }

  reconnectCount(): number {
    return this.reconnects;
  }

  // Post-membership-filter events accumulated since process start — not part of LiquidationFeedPort
  // (metrics wiring for this belongs to a separate lane/file, same as MetricsService's existing
  // pollErrorCount/forcedReconnectCount wiring for the sibling feeds).
  recordedEventCount(): number {
    return this.recordedEvents;
  }

  latest(symbol: SymbolId): LiquidationSnapshot | null {
    if (!this.streamHealthy()) return null;
    let perpKey: string;
    try {
      perpKey = perpSymbolFor(symbol);
    } catch {
      // Malformed symbol on a measurement path (never money/order, per the port's own header
      // comment) fails OPEN: omit the block rather than throw into the caller.
      return null;
    }
    // No subscribed perp market for this symbol (never configured, or pruned by runLoop as
    // venue-unlisted) — omit the block rather than answer a fabricated "zero liquidations seen"
    // snapshot (defect-145 recurrence: a spot symbol with no perp sibling, e.g. DOGE/USDT, must
    // never look like a healthy, genuinely quiet perp market).
    if (!this.subscribed.has(perpKey)) return null;
    this.maybeWarnZeroEvents();
    const windowMin = this.options.windowMin ?? DEFAULT_WINDOW_MIN;
    const buf = this.prune(perpKey, windowMin);
    let longNotional = 0;
    let shortNotional = 0;
    for (const s of buf) {
      if (s.side === 'long') longNotional += s.notionalUsd;
      else shortNotional += s.notionalUsd;
    }
    const total = longNotional + shortNotional;
    return {
      asOf: epochMs(this.options.clock.now()),
      windowMin,
      liqNotionalUsd: total,
      longShareOfLiqs: total > 0 ? longNotional / total : null,
      count: buf.length,
    };
  }

  private async runLoop(): Promise<void> {
    // Not every spot listing has a same-named perp market (e.g. PEPE/SHIB trade as 1000x-prefixed
    // variants on binanceusdm). One missing symbol fails the whole multi-symbol watch call, so a
    // venue rejection prunes that symbol and retries immediately — a measurement feed fails OPEN
    // per symbol, never spinning the reconnect loop for a permanent listing gap (L1 soak finding,
    // 2026-07-18).
    let perpSymbols = this.options.symbols.map((s) => perpSymbolFor(s));
    while (this.running && perpSymbols.length > 0) {
      try {
        const events = await this.source.watchLiquidationsForSymbols(perpSymbols);
        if (!this.healthy) {
          // Fresh health period after a reconnect — give the zero-event alarm a clean window
          // rather than counting the outage time toward it.
          this.healthy = true;
          this.healthySinceMs = this.options.clock.now();
          this.warnedZeroEvents = false;
        }
        for (const ev of events) this.record(ev);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const missing = perpSymbols.find((p) => msg.includes(`does not have market symbol ${p}`));
        if (missing) {
          perpSymbols = perpSymbols.filter((p) => p !== missing);
          // Also drop it from the membership index latest() consults — otherwise a pruned symbol
          // keeps answering a fabricated zero forever instead of the null this null-vs-quiet
          // contract requires for an unsubscribed market (see latest() above).
          this.subscribed.delete(missing);
          this.options.logger?.warn(
            `liquidation-feed: excluding ${missing} — venue has no such perp market (spot-only or 1000x-prefixed listing); ${perpSymbols.length} symbols remain`,
          );
          continue;
        }
        this.healthy = false;
        this.reconnects += 1;
        this.options.logger?.warn(`liquidation-feed stream error, reconnecting: ${msg}`);
        if (!this.running) break;
        await this.backoff();
      }
    }
    if (this.running && perpSymbols.length === 0) {
      this.healthy = false;
      this.options.logger?.warn(
        'liquidation-feed: no venue-supported perp symbols remain — feed inactive for this deployment',
      );
    }
  }

  private record(ev: LiquidationEvent): void {
    // ev.symbol is already ccxt's unified perp string — checked and stored in that same form,
    // never round-tripped through a spot conversion (defect-145: that round trip is what diverged
    // from a perp-form configured basket and dropped every event).
    if (!this.subscribed.has(ev.symbol)) return;
    const side: 'long' | 'short' = ev.side === 'buy' ? 'short' : 'long';
    const buf = this.windows.get(ev.symbol) ?? [];
    buf.push({
      ts: this.options.clock.now(),
      notionalUsd: toNotionalUsd(ev),
      side,
    });
    this.windows.set(ev.symbol, buf);
    this.recordedEvents += 1;
  }

  // Prunes samples older than `windowMin` for `perpKey` (ccxt unified perp string) and returns the
  // retained buffer.
  private prune(perpKey: string, windowMin: number): readonly LiqSample[] {
    const buf = this.windows.get(perpKey) ?? [];
    const cutoff = this.options.clock.now() - windowMin * 60_000;
    while (buf.length > 0 && buf[0]!.ts < cutoff) buf.shift();
    this.windows.set(perpKey, buf);
    return buf;
  }

  // One-shot alarm for the failure mode defect-145 found invisible: a stream that reports healthy
  // yet has recorded nothing is indistinguishable from a genuinely quiet market without this check.
  // Measurement-path logging only — never throws, never affects latest()'s return value.
  private maybeWarnZeroEvents(): void {
    if (this.warnedZeroEvents || this.recordedEvents > 0 || this.healthySinceMs === null) return;
    if (this.options.clock.now() - this.healthySinceMs < ZERO_EVENT_WARN_MS) return;
    this.warnedZeroEvents = true;
    this.options.logger?.warn(
      `liquidation-feed: stream has stayed healthy for over ${ZERO_EVENT_WARN_MS / 60_000}min with zero recorded events — verify the venue's forceOrder symbol form still matches the subscription index`,
    );
  }

  private async backoff(): Promise<void> {
    await new Promise<void>((res) => setTimeout(res, this.options.backoffMs ?? DEFAULT_BACKOFF_MS));
  }
}
