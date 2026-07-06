import { Injectable, Inject } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import { makeBucket, tryConsume, type TokenBucket } from '../../../domain/risk/rate-bucket';

// §5 R1 token buckets. Order-path intents must pass global + per-symbol + per-strategy.
// FLATTEN uses a reserved bucket so a runaway strategy can never starve a flatten.
// Consumption is all-or-nothing: a partial pass commits nothing (refill is recomputed
// from lastRefillMs next call, so no capacity is burned on a blocked attempt).
const GLOBAL = { cap: 10, rps: 10 };
const SYMBOL = { cap: 2, rps: 2 };
const STRATEGY = { cap: 4, rps: 4 };
const FLATTEN = { cap: 5, rps: 5 };
const RUNAWAY_WINDOW_MS = 5000;
const RUNAWAY_COUNT = 25;

export interface RateDecision {
  readonly allowed: boolean;
  readonly runaway: boolean;
}

@Injectable()
export class RateBucketsService {
  private global: TokenBucket;
  private flatten: TokenBucket;
  private readonly perSymbol = new Map<string, TokenBucket>();
  private readonly perStrategy = new Map<string, TokenBucket>();
  private rejectTimes: number[] = [];

  constructor(@Inject(CLOCK) private readonly clock: ClockPort) {
    const now = this.clock.now();
    this.global = makeBucket(GLOBAL.cap, now);
    this.flatten = makeBucket(FLATTEN.cap, now);
  }

  check(symbol: string, strategyId: string, isFlatten: boolean): RateDecision {
    const now = this.clock.now();

    if (isFlatten) {
      const r = tryConsume(this.flatten, FLATTEN.cap, FLATTEN.rps, now);
      this.flatten = r.bucket;
      return { allowed: r.allowed, runaway: false };
    }

    const g = tryConsume(this.global, GLOBAL.cap, GLOBAL.rps, now);
    const sym = this.perSymbol.get(symbol) ?? makeBucket(SYMBOL.cap, now);
    const strat = this.perStrategy.get(strategyId) ?? makeBucket(STRATEGY.cap, now);
    const s = tryConsume(sym, SYMBOL.cap, SYMBOL.rps, now);
    const st = tryConsume(strat, STRATEGY.cap, STRATEGY.rps, now);

    if (g.allowed && s.allowed && st.allowed) {
      this.global = g.bucket;
      this.perSymbol.set(symbol, s.bucket);
      this.perStrategy.set(strategyId, st.bucket);
      return { allowed: true, runaway: false };
    }

    // Blocked: commit nothing, record the reject, evaluate runaway escalation.
    this.rejectTimes = this.rejectTimes.filter((t) => now - t < RUNAWAY_WINDOW_MS);
    this.rejectTimes.push(now);
    return { allowed: false, runaway: this.rejectTimes.length >= RUNAWAY_COUNT };
  }
}
