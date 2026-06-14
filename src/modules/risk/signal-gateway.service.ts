import { Injectable, Inject } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../ports/clock';
import { KillSwitchService } from './kill-switch.service';
import { PositionSizerService } from './position-sizer.service';
import { RiskEngineService } from './risk-engine.service';
import type { Signal } from '../../domain/types/signal';
import type { PortfolioSnapshot } from '../../domain/types/portfolio';
import type { GatewayOutcome, SignalGatewayPort } from '../../ports/risk';

export type { GatewayOutcome };

// SignalGateway: the fast-fail front door to Risk. TTL + dedupe + kill-switch gate,
// then PositionSizer → RiskEngine. Strategies' signals reach Execution only through here.
@Injectable()
export class SignalGatewayService implements SignalGatewayPort {
  // dedupeKey → expiry epoch-ms (eventTime + ttlMs). Bounded, not the unbounded Set it replaces:
  // an entry is evicted once the event-time clock passes its expiry. Replay is safe — a replayed
  // signal carries the same eventTime (the key is replay-deterministic) hence the same expiry, so
  // the TTL gate below already rejects it as EXPIRED before the dedupe check; eviction can never
  // reintroduce a live duplicate. Keyed off the injected clock, never wall time, to stay replay-stable.
  private readonly seen = new Map<string, number>();

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly killSwitch: KillSwitchService,
    private readonly sizer: PositionSizerService,
    private readonly engine: RiskEngineService,
  ) {}

  accept(signal: Signal, snapshot: PortfolioSnapshot): GatewayOutcome {
    // Kill-switch fast-fail: nothing new is sized while halted.
    if (this.killSwitch.state() !== 'RUNNING') {
      return { status: 'GATEWAY_REJECTED', reason: 'KILL_SWITCH' };
    }
    const now = this.clock.now();
    const expiresAt = signal.eventTime + signal.ttlMs;
    // TTL: a stale signal is dropped (Risk rejects expired anyway; fail fast here).
    if (now > expiresAt) {
      return { status: 'GATEWAY_REJECTED', reason: 'EXPIRED' };
    }
    this.evictExpired(now);
    // Dedupe: replay-deterministic key; a repeat is a strategy bug, not new desire.
    if (this.seen.has(signal.dedupeKey)) {
      return { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' };
    }
    this.seen.set(signal.dedupeKey, expiresAt);

    const sized = this.sizer.size(signal, snapshot);
    if (!sized.ok) return { status: 'SIZING_REJECTED', reason: sized.reason };

    return { status: 'DECIDED', decision: this.engine.evaluate(sized.intent, snapshot) };
  }

  // Live dedupe keys retained — bounded by the max in-flight signal TTL window. Observability hook.
  get pendingDedupeCount(): number {
    return this.seen.size;
  }

  private evictExpired(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (now > expiresAt) this.seen.delete(key);
    }
  }
}
