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

// Injected sizing dependencies. baseNotional (quote) scales by signal strength;
// filters carry per-symbol exchange constraints; randomBytes feeds the UUIDv7.
export interface SizerDeps {
  readonly baseNotional: string;
  readonly mode: TradingMode;
  readonly filters: ReadonlyMap<string, SymbolFilters>;
  readonly randomBytes: (n: number) => Uint8Array;
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
  | { readonly ok: false; readonly reason: 'BELOW_MINIMUM' | 'NO_REF_PRICE' };

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

// Journaling sink so modules/risk never imports modules/persistence (boundary wall).
// No-op default in RiskModule; app-level wiring records to the risk_decisions repo.
export interface RiskJournalPort {
  record(decision: RiskDecision): void;
}

// SignalGateway outcome (§2.3 front door). DECIDED carries the RiskEngine verdict; the two
// REJECTED shapes are fast-fails before sizing/evaluation.
export type GatewayOutcome =
  | { readonly status: 'GATEWAY_REJECTED'; readonly reason: 'KILL_SWITCH' | 'EXPIRED' | 'DUPLICATE' }
  | { readonly status: 'SIZING_REJECTED'; readonly reason: 'BELOW_MINIMUM' | 'NO_REF_PRICE' }
  | { readonly status: 'DECIDED'; readonly decision: RiskDecision };

// The fast-fail front door to Risk (kill/TTL/dedupe → sizer → engine). Exposed as a port so
// the Strategy→Risk→Execution orchestrator can route signals without importing modules/risk.
export interface SignalGatewayPort {
  accept(signal: Signal, snapshot: PortfolioSnapshot): GatewayOutcome;
}
