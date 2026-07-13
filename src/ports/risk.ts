import type { Signal } from '../domain/types/signal';
import type { OrderIntent } from '../domain/types/order-intent';
import type { RiskDecision } from '../domain/types/risk-decision';
import type { PortfolioSnapshot } from '../domain/types/portfolio';
import type { KillSwitchState } from '../domain/risk/kill-switch';
import type { SymbolFilters } from '../domain/risk/evaluate';
import type { PartialRiskLimits } from '../domain/risk/limits';
import type { TradingMode } from '../domain/types/mode';

export const RISK_SIGNING_KEY = Symbol('RISK_SIGNING_KEY');
export const RISK_LIMITS = Symbol('RISK_LIMITS');
export const RISK_ENGINE = Symbol('RISK_ENGINE');
export const POSITION_SIZER = Symbol('POSITION_SIZER');
export const SIGNAL_GATEWAY = Symbol('SIGNAL_GATEWAY');
export const KILL_SWITCH = Symbol('KILL_SWITCH');
export const RISK_JOURNAL = Symbol('RISK_JOURNAL');
// Composition-root override (mirrors EXECUTION_STORE_OVERRIDE): when the DB path is active the root
// binds a RiskDecisionJournalAdapter here; RiskModule's RISK_JOURNAL falls back to its no-op when absent.
export const RISK_JOURNAL_OVERRIDE = Symbol('RISK_JOURNAL_OVERRIDE');
export const SIZER_DEPS = Symbol('SIZER_DEPS');
export const RISK_ENGINE_DEPS = Symbol('RISK_ENGINE_DEPS');
export const PROTECTIVE_EXIT_CONFIG = Symbol('PROTECTIVE_EXIT_CONFIG');
// Plan-stop watcher (Push 3 P2): the plan-managed stop price per open position, populated by
// AgenticStrategy the moment a plan's entry fills (see PlanStopRegistryPort below) and consulted by
// ProtectiveExitService's 1s tick BEFORE the global-% backstop logic. Symbol'd (not a class token)
// so both the strategy factory and ProtectiveExitService resolve the SAME singleton without either
// importing the other's concrete class (mirrors SIGNAL_SINK's own token convention).
export const PLAN_STOP_REGISTRY = Symbol('PLAN_STOP_REGISTRY');

// ProtectiveExitService tunables (bot-side stop-loss/trailing-stop backstop). stopLossPct/
// trailingPct are decimal-string fractions ('0' disables each independently); cooldownMs floors how
// often the service may re-fire a protective exit for the same symbol; filters mirrors SIZER_DEPS'
// own per-symbol constraints (dust-skip check only — the sizer does its own, authoritative filtering).
export interface ProtectiveExitConfig {
  readonly stopLossPct: string;
  readonly trailingPct: string;
  readonly cooldownMs: number;
  readonly filters: ReadonlyMap<string, SymbolFilters>;
  // Plan-stop watcher (Push 3 P2): '0' behavior stays byte-identical (the registry is never
  // consulted). When true, tick() checks the plan-stop registry for each live position BEFORE the
  // global stopLossPct/trailingPct logic above — a hit fully owns that position for the tick
  // (registry-based crossing check instead of the global-% one), a miss falls through unchanged.
  // Rollback = flip this back to false.
  readonly planStopWatchEnabled: boolean;
  // Force-fire threshold (bps): a registry entry whose venueStopResting is true stands down UNLESS
  // the breach beyond the plan's stop price exceeds this many bps — a resting venue stop should
  // already have filled at a small breach, so a wide miss means the venue order failed and the
  // bot-side watcher must not defer to it indefinitely.
  readonly planStopForceBps: number;
}

// Plan-stop watcher (Push 3 P2): one entry per plan-managed LONG/SHORT position, keyed by
// positionKey(strategyId, venue, symbol) (domain/risk/evaluate.ts) — the SAME key
// ProtectiveExitService's own hwm/lwm/cooldown maps use. venueStopResting is future-proofing for a
// later venue-side-stop build (a later phase places and maintains a real resting stop order there);
// it defaults false today, so the watcher never stands down on it yet.
export interface PlanStop {
  readonly side: 'LONG' | 'SHORT';
  readonly stopPrice: string;
  readonly venueStopResting: boolean;
}

export interface PlanStopRegistryPort {
  set(key: string, stop: PlanStop): void;
  clear(key: string): void;
  get(key: string): PlanStop | undefined;
  entries(): ReadonlyMap<string, PlanStop>;
}

// Injected sizing dependencies. baseNotional (quote) scales by signal strength;
// filters carry per-symbol exchange constraints; randomBytes feeds the UUIDv7.
export interface SizerDeps {
  readonly baseNotional: string;
  readonly mode: TradingMode;
  readonly filters: ReadonlyMap<string, SymbolFilters>;
  readonly randomBytes: (n: number) => Uint8Array;
  // Marketable-exit crossing buffer (bps) for reduce-only intents — how far the IOC limit crosses
  // the spread so a partial fill doesn't leave sub-minNotional dust resting away from market.
  // Optional so existing test fixtures that omit it keep booting; PositionSizerService falls back
  // to 25 (mirrors risk.module's SIZER_DEPS factory default).
  readonly exitCrossBufferBps?: number;
  // Compounding position sizing (P5): fraction of equity sized per entry (0..1). Optional so
  // existing test fixtures that omit it keep booting; PositionSizerService falls back to '0'
  // (disabled — legacy baseNotional × strength path), mirroring risk.module's SIZER_DEPS factory.
  readonly equityFraction?: string;
  // Entry order type: 'LIMIT_MAKER' rests non-reduce-only intents post-only (maker fee). Optional
  // so existing test fixtures that omit it keep booting; PositionSizerService falls back to
  // 'LIMIT' (disabled — byte-identical to pre-knob behavior), mirroring risk.module's SIZER_DEPS
  // factory. Exits (reduceOnly) always stay 'LIMIT'+IOC regardless of this knob.
  readonly entryOrderType?: 'LIMIT' | 'LIMIT_MAKER';
  // Protective-stop limit-leg buffer (Push 3 P7b, bps): a RESTING_STOP exit on a spot venue rests a
  // STOP_LOSS_LIMIT whose limit leg sits this many bps past the trigger (SELL leg below, BUY-cover
  // leg above), so the leg is immediately marketable once the trigger fires. Optional so existing
  // test fixtures that omit it keep booting; PositionSizerService falls back to 50, mirroring
  // risk.module's SIZER_DEPS factory default.
  readonly stopLimitBufferBps?: number;
  // Perp/swap entry-sizing caps (B2, domain/risk/perp-sizing.ts). Optional so existing spot-only
  // fixtures keep booting unchanged — absent ⇒ a perp-venue entry sizes with no additional cap,
  // which is moot anyway since nothing emits a perp-venue Signal yet (B1's adapter is unwired).
  readonly perp?: {
    readonly leverageCap: string;
    readonly mmrFallback: string;
    readonly liqBufferPct: string;
    // Funding-aware sizing hook — see perp-sizing.ts's applyFundingScaling. No consumer yet.
    readonly expectedFundingBpsPerHold?: string;
  };
}

// Injected RiskEngine dependencies. The signing key is process-lifetime random
// (composition root); limitsVersion stamps each approval for audit.
export interface RiskEngineDeps {
  readonly key: Buffer | string;
  readonly limits: PartialRiskLimits;
  readonly limitsVersion: string;
  readonly mode: TradingMode;
  readonly filters: ReadonlyMap<string, SymbolFilters>;
  readonly randomBytes: (n: number) => Uint8Array;
}

export interface KillSwitchPort {
  state(): KillSwitchState;
  engage(reason: string, flatten: boolean): void;
  // The three lifecycle progressions Execution's halt coordinator may drive. RAW dispatch is
  // deliberately NOT exposed: ENGAGE is reachable via engage(), and RESUME (disengage) is
  // manual-operator-only (typed confirmation), never on the execution surface (§5).
  confirmCancels(): void; // HALTING: all open orders cancelled ⇒ HALTED or FLATTENING
  cancelTimeout(): void; // HALTING: cancels unconfirmed in 10s ⇒ HALTED_DEGRADED
  allFlat(): void; // FLATTENING: every |position| < exchange min ⇒ HALTED
}

// PositionSizer turns a Signal (conviction) into a concrete OrderIntent, or rejects
// it below the exchange minimum (never a dust order).
export type SizingResult =
  | { readonly ok: true; readonly intent: OrderIntent }
  // NO_POSITION: an exit signal with no attributed position to reduce (a benign strategy no-op).
  // BELOW_MINIMUM: a genuinely sized order under the venue minQty/minNotional (the dust case).
  // Kept distinct so trade-activity analysis isn't misled by conflating the two.
  | { readonly ok: false; readonly reason: 'BELOW_MINIMUM' | 'NO_REF_PRICE' | 'NO_POSITION' };

export interface PositionSizerPort {
  size(signal: Signal, snapshot: PortfolioSnapshot): SizingResult;
}

export interface RiskEnginePort {
  // Sole minter of RiskApprovedIntent: pure §5 evaluation + HMAC proof + journaling.
  evaluate(intent: OrderIntent, snapshot: PortfolioSnapshot): RiskDecision;
  // The kill-switch FLATTEN path (§5 G0 carve-out): evaluates a reduce-only intent with
  // isFlatten=true (band/notional clamp instead of hard-reject, passes G0 during FLATTENING) and
  // draws from the reserved flatten rate bucket. Same minting + journaling as evaluate.
  evaluateFlatten(intent: OrderIntent, snapshot: PortfolioSnapshot): RiskDecision;
}

// Journaling sink so features/trading/risk never imports database (boundary wall).
// No-op default in RiskModule; app-level wiring records to the risk_decisions repo.
export interface RiskJournalPort {
  record(decision: RiskDecision): void;
}

// SignalGateway outcome (§2.3 front door). DECIDED carries the RiskEngine verdict; the two
// REJECTED shapes are fast-fails before sizing/evaluation.
export type GatewayOutcome =
  | {
      readonly status: 'GATEWAY_REJECTED';
      readonly reason: 'KILL_SWITCH' | 'EXPIRED' | 'DUPLICATE';
    }
  | {
      readonly status: 'SIZING_REJECTED';
      readonly reason: 'BELOW_MINIMUM' | 'NO_REF_PRICE' | 'NO_POSITION';
    }
  | { readonly status: 'DECIDED'; readonly decision: RiskDecision };

// The fast-fail front door to Risk (kill/TTL/dedupe → sizer → engine). Exposed as a port so
// the Strategy→Risk→Execution orchestrator can route signals without importing features/trading/risk.
export interface SignalGatewayPort {
  accept(signal: Signal, snapshot: PortfolioSnapshot): GatewayOutcome;
}
