import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { SymbolId } from '../../../domain/common/types/ids';
import { epochMs, symbolId } from '../../../domain/common/types/ids';
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
// a perp-only concept (spot has no forced-liquidation mechanism).
function perpSymbolFor(symbol: SymbolId): string {
  const { base, quote } = splitSymbol(symbol);
  return `${base}/${quote}:${quote}`;
}

// Reverses perpSymbolFor: 'BTC/USDT:USDT' -> SymbolId('BTC/USDT'). A malformed/unexpected perp
// string (no ':') is returned as-is — toSymbolId's own caller only ever feeds it ccxt's own unified
// symbol, so this is a defensive fallback, not an expected path.
function spotSymbolFromPerp(perp: string): SymbolId {
  const [spot] = perp.split(':');
  return symbolId(spot ?? perp);
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
 */
@Injectable()
export class LiquidationFeedService implements LiquidationFeedPort, OnModuleInit, OnModuleDestroy {
  private running = false;
  // Optimistically true the moment the loop starts (see start()) — there is no observable
  // "still connecting" state distinct from "running, no event yet" over a single watch() call, so a
  // freshly started stream with zero events is HEALTHY, not stale (the brief's own distinction).
  private healthy = false;
  private reconnects = 0;
  private readonly windows = new Map<SymbolId, LiqSample[]>();

  constructor(
    private readonly source: LiquidationWatchSource,
    private readonly options: LiquidationFeedOptions,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.healthy = true;
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

  latest(symbol: SymbolId): LiquidationSnapshot | null {
    if (!this.streamHealthy()) return null;
    const windowMin = this.options.windowMin ?? DEFAULT_WINDOW_MIN;
    const buf = this.prune(symbol, windowMin);
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
        this.healthy = true;
        for (const ev of events) this.record(ev);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const missing = perpSymbols.find((p) => msg.includes(`does not have market symbol ${p}`));
        if (missing) {
          perpSymbols = perpSymbols.filter((p) => p !== missing);
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
    const symbol = spotSymbolFromPerp(ev.symbol);
    // Only symbols this deployment actually trades accumulate a window — an unrequested symbol
    // slipping through (should not happen; ccxt subscribes exactly to `perpSymbols`) is dropped
    // rather than growing an unbounded map.
    if (!this.options.symbols.includes(symbol)) return;
    const side: 'long' | 'short' = ev.side === 'buy' ? 'short' : 'long';
    const buf = this.windows.get(symbol) ?? [];
    buf.push({
      ts: this.options.clock.now(),
      notionalUsd: toNotionalUsd(ev),
      side,
    });
    this.windows.set(symbol, buf);
  }

  // Prunes samples older than `windowMin` for `symbol` and returns the retained buffer.
  private prune(symbol: SymbolId, windowMin: number): readonly LiqSample[] {
    const buf = this.windows.get(symbol) ?? [];
    const cutoff = this.options.clock.now() - windowMin * 60_000;
    while (buf.length > 0 && buf[0]!.ts < cutoff) buf.shift();
    this.windows.set(symbol, buf);
    return buf;
  }

  private async backoff(): Promise<void> {
    await new Promise<void>((res) => setTimeout(res, this.options.backoffMs ?? DEFAULT_BACKOFF_MS));
  }
}
