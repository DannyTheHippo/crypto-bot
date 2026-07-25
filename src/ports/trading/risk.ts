import type { Signal } from '../domain/types/signal';
import type { OrderIntent } from '../domain/types/order-intent';
import type { RiskDecision } from '../domain/types/risk-decision';
import type { PortfolioSnapshot } from '../domain/types/portfolio';
import type { KillSwitchState } from '../domain/risk/kill-switch';
import type { SymbolFilters } from '../domain/risk/evaluate';
import type { PartialRiskLimits } from '../domain/risk/limits';
import type { TradingMode } from '../domain/types/mode';
import type { VenueId } from '../domain/types/ids';

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
// ProtectiveExitService's own hwm/lwm/cooldown maps use. venueStopResting was future-proofing for a
// later venue-side-stop build; Push 3 P7d is that build — AgenticStrategy (the sole writer) now
// flips it true only once a placed stop is CONFIRMED resting (ack observed via restingOrderForRole
// on spot, or a matching fetchOpenAlgoOrders row on a perp — never optimistically at signal-emission
// time, so the watcher/executor never stand down on a stop that may not have actually landed) and
// false again the moment a reconcile bar finds it missing (filled, cancelled, or never acked).
export interface PlanStop {
  readonly side: 'LONG' | 'SHORT';
  readonly stopPrice: string;
  readonly venueStopResting: boolean;
  // Push 3 P7d: the venue's own algo-rail id for a resting PERP STOP_MARKET (binanceusdm's algo
  // rail — never populated for a spot STOP_LOSS_LIMIT, which rests on the regular open-orders rail
  // and is cancelled via the ordinary CANCEL_OPEN/cancelRole 'vsl' path instead). Set the same bar
  // venueStopResting flips true on the perp path; cleared alongside it. Cancel callers (the
  // strategy's own cancel-first, ProtectiveExitService.fire()) key off THIS field's presence to
  // decide "perp algo-rail cancel" vs "spot open-orders cancel" without re-deriving venue-ness.
  readonly algoId?: string;
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
  // v3 §6/§6.1: the agentic lane's own sizing directive (Signal.sizeFraction) is capped at this
  // PER-VENUE fraction of cappedEquity (spot vs perp — AGENTIC_MAX_POSITION_FRACTION_SPOT/PERP),
  // and it also bounds same-side scale-in headroom. Replaces the single lane-wide
  // `maxAgentPositionFraction` (v2/transitional) — a venue's own class (spot/perp) picks its
  // fraction, keyed by VenueId (domain/types/venue-map.ts's SPOT_VENUE_ID/PERP_VENUE_ID). Optional
  // so existing test fixtures and module-isolation boots that never set it keep booting;
  // PositionSizerService falls back to '0.15' for any venue with no entry.
  readonly maxAgentPositionFractionByVenue?: ReadonlyMap<VenueId, string>;
  // S2/C1: SIZER_EQUITY_CAP — every notional-computing path in PositionSizerService sizes off
  // min(actualEquity, equityCap) instead of raw equity when this is a finite-positive money string,
  // so a demo account earns its promotion verdict at exactly live-book proportions (Design § Live-
  // scale economics). Optional; absent or non-finite/non-positive ⇒ actual equity passes through
  // unchanged (byte-identical to pre-cap behavior).
  readonly equityCap?: string;
  // v3 §6.1/§6.2: fixed wallet split of the one book (AppConfig.venueCapitalSplit), decimal-string
  // shares keyed by VenueId — the sizer's NEW venueHeadroom(v) clamp reads this alongside each
  // venue's open + reserved notional (see position-sizer.service.ts's applyVenueHeadroomClamp).
  // Optional: absent (module-isolation boots, or before the composition root wires it off
  // AppConfig — the #5 integration item) ⇒ the clamp no-ops, byte-identical to pre-split sizing.
  readonly venueCapitalShare?: ReadonlyMap<VenueId, string>;
  // Profitability Edge Program: aggregate planned-stop entry risk cap — caps same-side cost
  // notional so held (|qty|×avgEntry) + reserved + proposed never exceeds cappedEquity × fraction /
  // signal.stopLossPct. Optional; '0' or absent ⇒ disabled (byte-identical). PositionSizerService
  // falls back to '0', mirroring risk.module's SIZER_DEPS factory default.
  readonly maxPlannedStopRiskFraction?: string;
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
  // Backlog #52: the last engage() reason — HaltCoordinatorService reads it to stamp the ops-event
  // halt.engage's own `reason` field (mirrors state() above: a pure current-status getter).
  reason(): string;
  engage(reason: string, flatten: boolean): void;
  // The three lifecycle progressions Execution's halt coordinator may drive. RAW dispatch is
  // deliberately NOT exposed beyond engage/resume: ENGAGE is reachable via engage(), RESUME via
  // resume() below — nothing else on this port reaches the reducer's other event shapes.
  confirmCancels(): void; // HALTING: all open orders cancelled ⇒ HALTED or FLATTENING
  cancelTimeout(): void; // HALTING: cancels unconfirmed in 10s ⇒ HALTED_DEGRADED
  allFlat(): void; // FLATTENING: every |position| < exchange min ⇒ HALTED
  // Owner-authorized 2026-07-22 (decision record: RecoveryCoordinatorService's own header comment):
  // disengage a HALTED/HALTED_DEGRADED switch back to RUNNING. Precondition-FREE by design, exactly
  // like engage() is ENGAGE-free of precondition checks — RecoveryCoordinatorService (its own
  // per-cause + universal preconditions + 2-pass debounce) is the SOLE caller; there is no other
  // resume path (a pre-feature "manual resume" was an operator restarting the process, never a
  // dispatch of this method). A no-op from RUNNING/HALTING/FLATTENING (the reducer only accepts
  // RESUME from HALTED/HALTED_DEGRADED, mirroring every other event's state-scoped handling).
  resume(): void;
}

// PositionSizer turns a Signal (conviction) into a concrete OrderIntent, or rejects
// it below the exchange minimum (never a dust order).
export type SizingResult =
  | { readonly ok: true; readonly intent: OrderIntent }
  // NO_POSITION: an exit signal with no attributed position to reduce (a benign strategy no-op).
  // BELOW_MINIMUM: a genuinely sized order under the venue minQty/minNotional (the dust case).
  // Kept distinct so trade-activity analysis isn't misled by conflating the two.
  | {
      readonly ok: false;
      readonly reason: 'BELOW_MINIMUM' | 'NO_REF_PRICE' | 'NO_POSITION' | 'INVALID_STOP_RISK';
    };

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
      readonly reason: 'BELOW_MINIMUM' | 'NO_REF_PRICE' | 'NO_POSITION' | 'INVALID_STOP_RISK';
    }
  | { readonly status: 'DECIDED'; readonly decision: RiskDecision };

// The fast-fail front door to Risk (kill/TTL/dedupe → sizer → engine). Exposed as a port so
// the Strategy→Risk→Execution orchestrator can route signals without importing features/trading/risk.
export interface SignalGatewayPort {
  accept(signal: Signal, snapshot: PortfolioSnapshot): GatewayOutcome;
}
