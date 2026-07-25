import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { ExchangePort } from '../../../ports/exchange';
import type { FundingPaymentsPort } from '../../../ports/funding-payments';
import type { TradingMode } from '../../../domain/types/mode';
import type { SymbolId, EpochMs } from '../../../domain/types/ids';
import { epochMs } from '../../../domain/types/ids';
import type { ClockPort } from '../../../ports/clock';

// First-ever poll for a symbol backfills this far rather than the venue's full listing history —
// bounded so a fresh deployment (or a symbol added mid-run) doesn't try to pull years of funding
// settlements in one call. Every later poll resumes from the DB cursor (latestFundingTimeMs), so
// this constant only ever matters once per (venue, symbol, mode).
const BACKFILL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export interface FundingIngestOptions {
  readonly symbols: readonly SymbolId[];
  readonly mode: TradingMode;
  readonly pollIntervalMs: number;
  readonly clock: ClockPort;
  readonly logger?: { warn: (msg: string) => void };
  // W1 (Grafana rebuild): narrow structural hook (same convention as logger above) — this module
  // never imports features/common/observability, so the composition root adapts the real
  // AgentMetricsRecorder.recordFundingIngested to this shape.
  readonly metrics?: { recordIngested(venue: string, symbol: string, count: number): void };
}

/**
 * REST-poll service for perp funding-payment settlements (P5b) — mirrors DerivativesFeedService's
 * poll-loop shape (start/stop, try/catch-per-symbol, error counter), but writes to durable storage
 * instead of an in-memory snapshot: promotion math must survive a restart (CLAUDE.md rule 5's
 * "persist before" spirit applied to a measurement feed, not the order path). A poll failure logs
 * and continues — never throws, never blocks trading (measurement gate fails OPEN). Feature-gated
 * OFF by default (FUNDING_INGEST_ENABLED) and only ever constructed when ExchangePort.
 * fetchFundingPayments is present (perp venue) and FUNDING_PAYMENTS is DB-bound — see app.module.ts.
 */
@Injectable()
export class FundingIngestService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSuccessAt: EpochMs | null = null;
  private errorCount = 0;
  // In-memory running total per symbol, accumulated across this process's polls — the payload
  // accrual line's data source (agent-prompt.ts's fundingAccrualQuote). Deliberately NOT "since the
  // current position opened": correlating against position-open timestamps would require reaching
  // into the strategy host's position tracking, out of scope for this pass (see P5b report). Resets
  // to zero on redeploy, same as every other in-memory feed cache in this codebase (derivatives,
  // trade-flow, positioning) — the DURABLE record is funding_payments; this is a display cache only.
  private readonly cumulative = new Map<SymbolId, Decimal>();
  // Max fundingTime already folded into `cumulative`, per symbol. Binance's income endpoint treats
  // `since` as INCLUSIVE, and the poll cursor (repo.latestFundingTimeMs) is exactly the last
  // persisted fundingTime — so every poll re-fetches the boundary settlement row already accrued by
  // the previous poll. The durable write is safe (ON CONFLICT DO NOTHING), but this cache has no
  // such dedupe on its own, so it must filter to strictly-newer rows before folding them in.
  private readonly accruedThroughMs = new Map<SymbolId, number>();

  constructor(
    private readonly exchangePort: ExchangePort,
    private readonly repo: FundingPaymentsPort,
    private readonly options: FundingIngestOptions,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  start(): void {
    if (this.timer) return;
    void this.pollAll();
    this.timer = setInterval(() => {
      void this.pollAll();
    }, this.options.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  lastSuccessfulPollAt(): EpochMs | null {
    return this.lastSuccessAt;
  }

  pollErrorCount(): number {
    return this.errorCount;
  }

  // Cumulative funding observed THIS PROCESS for symbol — null before the first successful poll.
  // See this.cumulative's own header comment for the "since process start, not since position open"
  // scope note.
  cumulativeAccrualQuote(symbol: SymbolId): string | null {
    return this.cumulative.get(symbol)?.toFixed() ?? null;
  }

  async pollAll(): Promise<void> {
    if (this.exchangePort.fetchFundingPayments === undefined) return;
    await Promise.all(this.options.symbols.map((s) => this.pollOne(s)));
  }

  private async pollOne(symbol: SymbolId): Promise<void> {
    try {
      const cursor = await this.repo.latestFundingTimeMs(
        this.exchangePort.venue,
        symbol,
        this.options.mode,
      );
      const sinceMs = epochMs(cursor ?? this.options.clock.now() - BACKFILL_LOOKBACK_MS);
      const rows = await this.exchangePort.fetchFundingPayments!(symbol, sinceMs);
      if (rows.length > 0) {
        await this.repo.record(rows.map((r) => ({ ...r, mode: this.options.mode })));
        // since=cursor is inclusive on the venue side, so `rows` may re-deliver the boundary row
        // from the previous poll — only fold rows strictly newer than what's already accrued.
        const priorThrough = this.accruedThroughMs.get(symbol);
        const newRows =
          priorThrough === undefined ? rows : rows.filter((r) => r.fundingTime > priorThrough);
        this.options.metrics?.recordIngested(
          this.exchangePort.venue,
          String(symbol),
          newRows.length,
        );
        if (newRows.length > 0) {
          const delta = newRows.reduce((sum, r) => sum.plus(r.amountQuote), new Decimal(0));
          const prev = this.cumulative.get(symbol) ?? new Decimal(0);
          this.cumulative.set(symbol, prev.plus(delta));
          const maxFundingTime = newRows.reduce(
            (max, r) => Math.max(max, r.fundingTime),
            priorThrough ?? -Infinity,
          );
          this.accruedThroughMs.set(symbol, maxFundingTime);
        } else if (!this.cumulative.has(symbol)) {
          this.cumulative.set(symbol, new Decimal(0));
        }
      } else if (!this.cumulative.has(symbol)) {
        // Distinguishes "polled, zero rows" from "never polled" for cumulativeAccrualQuote's null
        // contract — a symbol with genuinely zero funding settlements still reports '0', not null.
        this.cumulative.set(symbol, new Decimal(0));
      }
      this.lastSuccessAt = epochMs(this.options.clock.now());
    } catch (err) {
      this.errorCount += 1;
      this.options.logger?.warn(
        `funding-ingest poll failed for ${String(symbol)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
